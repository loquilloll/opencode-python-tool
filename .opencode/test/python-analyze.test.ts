import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("open() mode and path handling", () => {
    it("classifies positional and keyword read/write modes", async () => {
      expect(await analyze("open('f')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'r')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'rb')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'w')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'a')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'x')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'r+')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open(file='f', mode='w')")).toEqual([{ kind: "write", call: "open", path: "f" }])
    })

    it("classifies dynamic mode and dynamic path", async () => {
      expect(await analyze("open('f', mode_var)")).toEqual([{ kind: "unknown", call: "open-mode-dynamic" }])
      expect(await analyze("open(file_var)")).toEqual([{ kind: "read", call: "open", dynamicPath: true }])
      expect(await analyze("open(f'/tmp/{name}')")).toEqual([{ kind: "read", call: "open", dynamicPath: true }])
    })

    it("parses concatenated, triple, and raw string paths", async () => {
      expect(await analyze("open('a' 'b')")).toEqual([{ kind: "read", call: "open", path: "ab" }])
      expect(await analyze('open("""f""")')).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open(r'/tmp/f')")).toEqual([{ kind: "read", call: "open", path: "/tmp/f" }])
    })

    it("detects open in with statements", async () => {
      const events = await analyze("with open('data.txt') as handle:\n    pass")
      expect(events).toEqual([{ kind: "read", call: "open", path: "data.txt" }])
    })
  })

  describe("Path method classification", () => {
    it("classifies Path read/write methods with path extraction", async () => {
      const events = await analyze(
        [
          "Path('f').read_text()",
          "Path('f').read_bytes()",
          "Path('f').write_text('x')",
          "Path('f').write_bytes(b'x')",
          "Path('f').mkdir()",
          "Path('f').unlink()",
          "Path('f').touch()",
          "Path('f').rename('g')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", path: "f" },
          { kind: "read", call: "Path.read_bytes", path: "f" },
          { kind: "write", call: "Path.write_text", path: "f" },
          { kind: "write", call: "Path.write_bytes", path: "f" },
          { kind: "write", call: "Path.mkdir", path: "f" },
          { kind: "write", call: "Path.unlink", path: "f" },
          { kind: "write", call: "Path.touch", path: "f" },
          { kind: "write", call: "Path.rename", path: "f" },
        ]),
      )
    })

    it("marks dynamic Path constructor arguments as dynamicPath", async () => {
      const events = await analyze("Path(path_var).read_text()")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", dynamicPath: true },
          { kind: "unknown", call: "callable:Path" },
        ]),
      )
    })
  })

  describe("os/shutil write classification", () => {
    it("classifies path writes and destination path behavior", async () => {
      const events = await analyze(
        [
          "os.remove('f')",
          "os.unlink('f')",
          "os.makedirs('d')",
          "os.rename('a', 'b')",
          "os.replace('a', 'b')",
          "shutil.copy('a', 'b')",
          "shutil.copytree('a', 'b')",
          "shutil.move('a', 'b')",
          "shutil.rmtree('d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "write", call: "os.remove", path: "f" },
          { kind: "write", call: "os.unlink", dynamicPath: true },
          { kind: "write", call: "os.makedirs", path: "d" },
          { kind: "write", call: "os.rename", dynamicPath: true },
          { kind: "write", call: "os.replace", dynamicPath: true },
          { kind: "write", call: "shutil.copy", path: "b" },
          { kind: "write", call: "shutil.copytree", path: "b" },
          { kind: "write", call: "shutil.move", path: "b" },
          { kind: "write", call: "shutil.rmtree", path: "d" },
        ]),
      )
    })

    it("supports keyword dynamic path arguments", async () => {
      const events = await analyze("os.remove(path=target_path)")
      expect(events).toEqual([{ kind: "write", call: "os.remove", dynamicPath: true }])
    })
  })

  describe("json/yaml classification", () => {
    it("classifies json and yaml read/write calls", async () => {
      const events = await analyze([
        "json.load(f)",
        "json.dump(data, f)",
        "yaml.safe_load(f)",
        "yaml.dump(data, f)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "json.load" },
          { kind: "write", call: "json.dump" },
          { kind: "read", call: "yaml.safe_load" },
          { kind: "write", call: "yaml.dump" },
        ]),
      )
    })
  })

  describe("emit and pure classification", () => {
    it("classifies print/logging/warnings calls as emit", async () => {
      const events = await analyze([
        "print('hello')",
        "logging.info('ok')",
        "logging.warning('careful')",
        "warnings.warn('deprecated')",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "emit", call: "print" },
          { kind: "emit", call: "logging.info" },
          { kind: "emit", call: "logging.warning" },
          { kind: "emit", call: "warnings.warn" },
        ]),
      )
    })

    it("classifies obvious regex calls as pure", async () => {
      const events = await analyze([
        "re.search('a+', text)",
        "re.findall('a+', text)",
        "re.match('a+', text)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.search" },
          { kind: "pure", call: "re.findall" },
          { kind: "pure", call: "re.match" },
        ]),
      )
    })

    it("keeps unknown method-tail calls as unknown", async () => {
      const events = await analyze("service.info('ok')\nservice.search('a+')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:service.info" },
          { kind: "unknown", call: "callable:service.search" },
        ]),
      )
    })

    it("keeps re.sub outside pure classification", async () => {
      const events = await analyze("re.sub('a+', '-', text)")
      expect(events).toEqual([{ kind: "unknown", call: "callable:re.sub" }])
    })
  })

  describe("exec classification", () => {
    it("classifies subprocess, os, and dynamic execution builtins", async () => {
      const events = await analyze(
        [
          "subprocess.run(['ls'])",
          "subprocess.call(['ls'])",
          "subprocess.Popen(['ls'])",
          "subprocess.check_output(['ls'])",
          "os.system('ls')",
          "os.popen('ls')",
          "os.execvp('ls', ['ls'])",
          "eval('1+1')",
          "exec('print(1)')",
          "compile('x', 'f', 'exec')",
          "__import__('os')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "subprocess.run" },
          { kind: "exec", call: "subprocess.call" },
          { kind: "exec", call: "subprocess.Popen" },
          { kind: "exec", call: "subprocess.check_output" },
          { kind: "exec", call: "os.system" },
          { kind: "exec", call: "os.popen" },
          { kind: "exec", call: "os.execvp" },
          { kind: "exec", call: "eval" },
          { kind: "exec", call: "exec" },
          { kind: "exec", call: "compile" },
          { kind: "exec", call: "__import__" },
        ]),
      )
    })
  })

  describe("phase 5 network/db/tempfile/deserialization", () => {
    it("classifies network calls as exec", async () => {
      const events = await analyze(
        [
          "requests.get('https://example.com')",
          "urllib.request.urlopen('https://example.com')",
          "http.client.HTTPConnection('example.com')",
          "aiohttp.ClientSession()",
          "httpx.Client()",
          "socket.create_connection(('example.com', 443))",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.get" },
          { kind: "exec", call: "urllib.request.urlopen" },
          { kind: "exec", call: "http.client.HTTPConnection" },
          { kind: "exec", call: "aiohttp.ClientSession" },
          { kind: "exec", call: "httpx.Client" },
          { kind: "exec", call: "socket.create_connection" },
        ]),
      )
    })

    it("classifies database calls as exec", async () => {
      const events = await analyze(
        [
          "sqlite3.connect('app.db')",
          "psycopg2.connect('postgresql://localhost/db')",
          "pymysql.connect(host='localhost')",
          "sqlalchemy.create_engine('sqlite:///app.db')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "sqlite3.connect" },
          { kind: "exec", call: "psycopg2.connect" },
          { kind: "exec", call: "pymysql.connect" },
          { kind: "exec", call: "sqlalchemy.create_engine" },
        ]),
      )
    })

    it("classifies tempfile writers as write", async () => {
      const events = await analyze(
        [
          "tempfile.NamedTemporaryFile()",
          "tempfile.mkdtemp()",
          "tempfile.mkstemp()",
          "tempfile.TemporaryDirectory()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "write", call: "tempfile.NamedTemporaryFile" },
          { kind: "write", call: "tempfile.mkdtemp" },
          { kind: "write", call: "tempfile.mkstemp" },
          { kind: "write", call: "tempfile.TemporaryDirectory" },
        ]),
      )
    })

    it("classifies dangerous deserialization as exec", async () => {
      const events = await analyze(
        ["pickle.load(handle)", "pickle.loads(data)", "marshal.load(handle)", "marshal.loads(data)"].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "pickle.load" },
          { kind: "exec", call: "pickle.loads" },
          { kind: "exec", call: "marshal.load" },
          { kind: "exec", call: "marshal.loads" },
        ]),
      )
    })
  })

  describe("phase 11 oci coverage", () => {
    it("classifies known OCI constructors and pagination helpers as exec", async () => {
      const events = await analyze(
        [
          "oci.identity.IdentityClient(config)",
          "oci.core.ComputeClient(config)",
          "oci.core.VirtualNetworkClient(config)",
          "oci.object_storage.ObjectStorageClient(config)",
          "oci.database.DatabaseClient(config)",
          "oci.secrets.SecretsClient(config)",
          "oci.key_management.KmsManagementClient(config)",
          "oci.pagination.list_call_get_all_results(fetch_fn)",
          "oci.pagination.list_call_get_all_results_generator(fetch_fn)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "oci.identity.IdentityClient" },
          { kind: "exec", call: "oci.core.ComputeClient" },
          { kind: "exec", call: "oci.core.VirtualNetworkClient" },
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient" },
          { kind: "exec", call: "oci.database.DatabaseClient" },
          { kind: "exec", call: "oci.secrets.SecretsClient" },
          { kind: "exec", call: "oci.key_management.KmsManagementClient" },
          { kind: "exec", call: "oci.pagination.list_call_get_all_results" },
          { kind: "exec", call: "oci.pagination.list_call_get_all_results_generator" },
        ]),
      )
    })

    it("classifies oci.config.from_file as read with literal and dynamic paths", async () => {
      expect(await analyze("oci.config.from_file('~/.oci/config')")).toEqual([
        { kind: "read", call: "oci.config.from_file", path: "~/.oci/config" },
      ])

      expect(await analyze("oci.config.from_file(file_location=config_path)")).toEqual([
        { kind: "read", call: "oci.config.from_file", dynamicPath: true },
      ])
    })

    it("classifies chained OCI client method calls as exec", async () => {
      const events = await analyze(
        "oci.object_storage.ObjectStorageClient(config).put_object('ns', 'bucket', 'name', body)",
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient" },
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient.put_object" },
        ]),
      )
    })

    it("keeps OCI alias form as callable fallback unknown", async () => {
      const events = await analyze("import oci as cloud\ncloud.object_storage.ObjectStorageClient(config)")
      expect(events).toEqual([{ kind: "unknown", call: "callable:cloud.object_storage.ObjectStorageClient" }])
    })
  })

  describe("phase 12 ghapi coverage", () => {
    it("classifies direct ghapi module calls as exec", async () => {
      const events = await analyze(
        [
          "ghapi.all.GhApi(owner='o', repo='r')",
          "ghapi.core.GhApi(owner='o', repo='r')",
          "ghapi.graphql.gh_query('query { viewer { login } }')",
          "ghapi.page.paged(fetcher)",
          "ghapi.page.pages(fetcher)",
          "ghapi.auth.GhDeviceAuth()",
          "ghapi.auth.github_auth_device()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "ghapi.all.GhApi" },
          { kind: "exec", call: "ghapi.core.GhApi" },
          { kind: "exec", call: "ghapi.graphql.gh_query" },
          { kind: "exec", call: "ghapi.page.paged" },
          { kind: "exec", call: "ghapi.page.pages" },
          { kind: "exec", call: "ghapi.auth.GhDeviceAuth" },
          { kind: "exec", call: "ghapi.auth.github_auth_device" },
        ]),
      )
    })

    it("classifies GhApi convenience methods as exec", async () => {
      const events = await analyze(
        [
          "GhApi().create_gist(files={}, description='d')",
          "GhApi().create_release(tag_name='v1.0.0')",
          "GhApi.delete_release(release_id=1)",
          "GhApi.upload_file(path='dist.tgz')",
          "GhApi.enable_pages()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "GhApi.create_gist" },
          { kind: "exec", call: "GhApi.create_release" },
          { kind: "exec", call: "GhApi.delete_release" },
          { kind: "exec", call: "GhApi.upload_file" },
          { kind: "exec", call: "GhApi.enable_pages" },
        ]),
      )
    })

    it("classifies ghapi workflow helper calls as write", async () => {
      const events = await analyze(
        [
          "ghapi.actions.create_workflow_files(workflow='ci')",
          "ghapi.actions.create_workflow(name='ci')",
          "ghapi.actions.gh_create_workflow(name='ci')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "write", call: "ghapi.actions.create_workflow_files" },
          { kind: "write", call: "ghapi.actions.create_workflow" },
          { kind: "write", call: "ghapi.actions.gh_create_workflow" },
        ]),
      )
    })

    it("classifies GhApi instance variable group methods as normalized exec calls", async () => {
      const events = await analyze(
        [
          "api = GhApi()",
          "api.git.get_ref(owner='o', repo='r', ref='heads/main')",
          "client = ghapi.all.GhApi(owner='o', repo='r')",
          "client.issues.create(title='bug')",
          "core = ghapi.core.GhApi(owner='o', repo='r')",
          "core.repos.get(owner='o', repo='r')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "ghapi.git.get_ref" },
          { kind: "exec", call: "ghapi.issues.create" },
          { kind: "exec", call: "ghapi.repos.get" },
        ]),
      )
    })

    it("keeps ghapi alias form as callable fallback unknown", async () => {
      const events = await analyze("import ghapi.all as ga\nga.GhApi(owner='o', repo='r')")
      expect(events).toEqual([{ kind: "unknown", call: "callable:ga.GhApi" }])
    })
  })

  describe("phase 13 atlassian-python-api coverage", () => {
    it("classifies Atlassian constructors and dotted call surfaces as exec", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira, Confluence, Bitbucket, ServiceDesk, Crowd, Xray, CloudAdminOrgs, CloudAdminUsers",
          "Jira(url='https://example.atlassian.net')",
          "atlassian.Jira(url='https://example.atlassian.net')",
          "Confluence(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceCloud(url='https://example.atlassian.net/wiki')",
          "Bitbucket(url='https://bitbucket.org')",
          "atlassian.bitbucket.Cloud(username='u', password='p')",
          "ServiceDesk(url='https://example.atlassian.net')",
          "Crowd(url='https://crowd.example.com')",
          "Xray(url='https://example.atlassian.net')",
          "CloudAdminOrgs(token='x')",
          "CloudAdminUsers(token='x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "Jira" },
          { kind: "exec", call: "atlassian.Jira" },
          { kind: "exec", call: "Confluence" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceCloud" },
          { kind: "exec", call: "Bitbucket" },
          { kind: "exec", call: "atlassian.bitbucket.Cloud" },
          { kind: "exec", call: "ServiceDesk" },
          { kind: "exec", call: "Crowd" },
          { kind: "exec", call: "Xray" },
          { kind: "exec", call: "CloudAdminOrgs" },
          { kind: "exec", call: "CloudAdminUsers" },
        ]),
      )
    })

    it("classifies tracked instance methods with normalized Atlassian call IDs", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira, ConfluenceServer, ServiceDesk",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = DEMO')",
          "jira.issue_add_comment('DEMO-1', 'done')",
          "cf = ConfluenceServer(url='https://example.atlassian.net/wiki')",
          "cf.create_page(space='ENG', title='t', body='b')",
          "bb = atlassian.bitbucket.Cloud(username='u', password='p')",
          "bb.trigger_pipeline('workspace', 'repo')",
          "sd = ServiceDesk(url='https://example.atlassian.net')",
          "sd.get_queues(service_desk_id=1)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.jql" },
          { kind: "exec", call: "atlassian.jira.issue_add_comment" },
          { kind: "exec", call: "atlassian.confluence.create_page" },
          { kind: "exec", call: "atlassian.bitbucket.trigger_pipeline" },
          { kind: "exec", call: "atlassian.servicedesk.get_queues" },
        ]),
      )
    })

    it("falls back to callable unknown for unknown methods on tracked instances", async () => {
      const events = await analyze(
        "from atlassian import Jira\njira = Jira(url='https://example.atlassian.net')\njira.unknown_method()",
      )
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "Jira" },
          { kind: "unknown", call: "callable:jira.unknown_method" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "atlassian.jira.unknown_method" }]))
    })

    it("keeps Atlassian import alias behavior deferred", async () => {
      const events = await analyze("import atlassian as atl\nclient = atl.Jira(url='https://example.atlassian.net')\nclient.jql('project = DEMO')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:atl.Jira" },
          { kind: "unknown", call: "callable:client.jql" },
        ]),
      )
    })

    it("does not normalize tracked calls before assignment", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira",
          "jira.jql('project = DEMO')",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = APP')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:jira.jql" },
          { kind: "exec", call: "Jira" },
          { kind: "exec", call: "atlassian.jira.jql" },
        ]),
      )
    })

    it("invalidates tracked Atlassian instance on reassignment", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = DEMO')",
          "jira = build_client()",
          "jira.jql('project = APP')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.jql" },
          { kind: "unknown", call: "callable:build_client" },
          { kind: "unknown", call: "callable:jira.jql" },
        ]),
      )
    })

    it("keeps bare constructor names as unknown without Atlassian import provenance", async () => {
      const events = await analyze(
        [
          "class Jira:",
          "    def __init__(self):",
          "        pass",
          "",
          "    def jql(self, query):",
          "        return []",
          "",
          "client = Jira()",
          "client.jql('project = DEMO')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:Jira" },
          { kind: "unknown", call: "callable:client.jql" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "Jira" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "atlassian.jira.jql" }]))
    })

    it("supports consistent module-qualified constructor variants across client families", async () => {
      const events = await analyze(
        [
          "atlassian.jira.Jira(url='https://example.atlassian.net')",
          "atlassian.confluence.Confluence(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceCloud(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceServer(url='https://example.atlassian.net/wiki')",
          "atlassian.bitbucket.Bitbucket(url='https://bitbucket.org')",
          "atlassian.bitbucket.Cloud(username='u', password='p')",
          "atlassian.servicedesk.ServiceDesk(url='https://example.atlassian.net')",
          "atlassian.service_desk.ServiceDesk(url='https://example.atlassian.net')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.Jira" },
          { kind: "exec", call: "atlassian.confluence.Confluence" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceCloud" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceServer" },
          { kind: "exec", call: "atlassian.bitbucket.Bitbucket" },
          { kind: "exec", call: "atlassian.bitbucket.Cloud" },
          { kind: "exec", call: "atlassian.servicedesk.ServiceDesk" },
          { kind: "exec", call: "atlassian.service_desk.ServiceDesk" },
        ]),
      )
    })
  })

  describe("edge cases and fallbacks", () => {
    it("classifies empty, whitespace, parse-error, and no-calls paths", async () => {
      expect(await analyze("")).toEqual([{ kind: "unknown", call: "empty-source" }])
      expect(await analyze("   \n\t")).toEqual([{ kind: "unknown", call: "empty-source" }])
      expect(await analyze("def broken(:\n    pass")).toEqual([{ kind: "unknown", call: "parse-error" }])
      expect(await analyze("value = 1\nname = 'alice'")) .toEqual([{ kind: "unknown", call: "no-calls-detected" }])
    })

    it("emits callable-specific unknown events for unrecognized calls", async () => {
      const events = await analyze(["mypkg.do_thing()", "service.run_task('x')"].join("\n"))
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:mypkg.do_thing" },
          { kind: "unknown", call: "callable:service.run_task" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "no-classified-call" }]))
    })

    it("keeps alias calls as callable unknowns", async () => {
      const events = await analyze("import requests as rq\nrq.get('https://example.com')")
      expect(events).toEqual([{ kind: "unknown", call: "callable:rq.get" }])
    })

    it("uses dynamic-call fallback when callable identity cannot be resolved", async () => {
      const events = await analyze("(lambda x: x)(1)")
      expect(events).toEqual([{ kind: "unknown", call: "dynamic-call" }])
    })

    it("deduplicates identical events and supports mixed calls", async () => {
      const duplicate = await analyze("open('f', 'r')\nopen('f', 'r')")
      expect(duplicate).toEqual([{ kind: "read", call: "open", path: "f" }])

      const mixed = await analyze("open('f', 'r')\nos.remove('g')\nsubprocess.run(['ls'])\nmy_func()")
      expect(mixed).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "open", path: "f" },
          { kind: "write", call: "os.remove", path: "g" },
          { kind: "exec", call: "subprocess.run" },
          { kind: "unknown", call: "callable:my_func" },
        ]),
      )
    })
  })

  describe("decorator and nested contexts", () => {
    it("detects calls in decorator, class body, nested function, and list comprehension", async () => {
      const events = await analyze(
        [
          "@requests.get('https://example.com')",
          "class Task:",
          "    resource = Path('class.txt').write_text('ok')",
          "",
          "def outer():",
          "    def inner():",
          "        return os.remove('nested.txt')",
          "    return [open(item) for item in files]",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.get" },
          { kind: "write", call: "Path.write_text", path: "class.txt" },
          { kind: "write", call: "os.remove", path: "nested.txt" },
          { kind: "read", call: "open", dynamicPath: true },
        ]),
      )
    })
  })

  describe("rules file loading", () => {
    it("normalizes invalid json errors and retries after file fix", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, '{"version":1')
        await expect(analyze("open('f')")).rejects.toThrow(/^Invalid python-rules\.json: file contains invalid JSON/)

        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        await writeFile(file, await readFile(src, "utf8"))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects unsupported rules versions", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, unknown>
        data.version = 2
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: version must be 1")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed rules shapes", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.methods.read = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: methods.read must be a string[]")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("accepts legacy rules files that omit emit/pure buckets", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        delete data.methods.emit
        delete data.methods.pure
        delete data.calls.emit
        delete data.calls.pure
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})

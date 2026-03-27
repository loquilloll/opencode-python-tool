import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("github classification", () => {
    it("classifies exact direct-imported Github constructors as exec", async () => {
      const events = await analyze(
        [
          "from github import Github",
          "client = Github(login_or_token='x')",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "exec", call: "github.Github" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:github.Github" }]))
    })

    it("keeps module-qualified, aliased, captured, and shadowed Github constructors conservative", async () => {
      const moduleQualifiedEvents = await analyze(
        [
          "import github",
          "github.Github(login_or_token='x')",
        ].join("\n"),
      )

      const aliasEvents = await analyze(
        [
          "from github import Github as GH",
          "GH(login_or_token='x')",
        ].join("\n"),
      )

      const capturedEvents = await analyze(
        [
          "from github import Github",
          "Ctor = Github",
          "Ctor(login_or_token='x')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from github import Github",
          "def Github(*args, **kwargs):",
          "    return object()",
          "Github(login_or_token='x')",
        ].join("\n"),
      )

      expect(moduleQualifiedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:github.Github" }]))
      expect(moduleQualifiedEvents).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "github.Github" }]))
      expect(aliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:github.Github" }]))
      expect(aliasEvents).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "github.Github" }]))
      expect(capturedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:github.Github" }]))
      expect(capturedEvents).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "github.Github" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:Github" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "github.Github" }]))
    })
  })

  describe("model_dump classification", () => {
    it("classifies exact direct-imported OrganizationMembershipListOptions.model_validate instances on model_dump", async () => {
      const events = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "pytfe.models.organization_membership.OrganizationMembershipListOptions.model_dump" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:obj.model_dump" }]))
    })

    it("keeps model_dump conservative for module-qualified, aliased, captured, and shadowed validate sources", async () => {
      const moduleQualifiedEvents = await analyze(
        [
          "import pytfe.models.organization_membership as om",
          "obj = om.OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const aliasEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions as Options",
          "obj = Options.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const capturedEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "alias = obj",
          "alias.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "OrganizationMembershipListOptions = object()",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      for (const events of [moduleQualifiedEvents, aliasEvents, capturedEvents, shadowedEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:obj.model_dump" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "pytfe.models.organization_membership.OrganizationMembershipListOptions.model_dump" }]))
      }
    })

    it("keeps model_dump conservative after model_validate or model_dump rebinding", async () => {
      const assignedFactoryEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "OrganizationMembershipListOptions.model_validate = evil",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const setattrFactoryEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "setattr(OrganizationMembershipListOptions, 'model_validate', evil)",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const assignedMethodEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump = evil",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const setattrMethodEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "setattr(obj, 'model_dump', evil)",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const assignedClassMethodEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "OrganizationMembershipListOptions.model_dump = evil",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const setattrClassMethodEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "setattr(OrganizationMembershipListOptions, 'model_dump', evil)",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      const aliasFactoryEvents = await analyze(
        [
          "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
          "alias = OrganizationMembershipListOptions",
          "alias.model_validate = evil",
          "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
          "obj.model_dump(by_alias=True, exclude_none=True)",
        ].join("\n"),
      )

      for (const events of [assignedFactoryEvents, setattrFactoryEvents, assignedMethodEvents, setattrMethodEvents, assignedClassMethodEvents, setattrClassMethodEvents, aliasFactoryEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:obj.model_dump" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "pytfe.models.organization_membership.OrganizationMembershipListOptions.model_dump" }]))
      }
    })
  })

  describe("tabulate iterable classification", () => {
    it("classifies exact direct-imported tabulate_formats iteration as string-backed", async () => {
      const events = await analyze(
        [
          "from tabulate import tabulate_formats",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "f.lower" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:f.lower" }]))
    })

    it("keeps aliased, rebound, and module-qualified tabulate_formats iteration conservative", async () => {
      const aliasedImportEvents = await analyze(
        [
          "from tabulate import tabulate_formats as formats",
          "for f in formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const reboundEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "tabulate_formats = []",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const moduleQualifiedEvents = await analyze(
        [
          "import tabulate",
          "for f in tabulate.tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const appendedEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "tabulate_formats.append(obj)",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const subscriptEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "tabulate_formats[0] = obj",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const aliasSubscriptEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "alias = tabulate_formats",
          "alias[0] = obj",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const augmentedEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "tabulate_formats += [obj]",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      const aliasAugmentedEvents = await analyze(
        [
          "from tabulate import tabulate_formats",
          "alias = tabulate_formats",
          "alias += other",
          "for f in tabulate_formats:",
          "    f.lower()",
        ].join("\n"),
      )

      for (const events of [aliasedImportEvents, reboundEvents, moduleQualifiedEvents, appendedEvents, subscriptEvents, aliasSubscriptEvents, augmentedEvents, aliasAugmentedEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:f.lower" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "f.lower" }]))
      }
    })
  })

  describe("RequestInformation classification", () => {
    it("classifies zero-arg direct-imported RequestInformation constructors as pure", async () => {
      const directEvents = await analyze(
        [
          "from kiota_abstractions.request_information import RequestInformation",
          "RequestInformation()",
          "dir(RequestInformation())",
        ].join("\n"),
      )

      expect(directEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "kiota_abstractions.request_information.RequestInformation" }, { kind: "pure", call: "dir" }]))
    })

    it("keeps RequestInformation conservative when module-qualified, aliased, shadowed, or called with args", async () => {
      const moduleQualifiedEvents = await analyze(
        [
          "import kiota_abstractions.request_information",
          "kiota_abstractions.request_information.RequestInformation()",
        ].join("\n"),
      )

      const aliasEvents = await analyze(
        [
          "from kiota_abstractions.request_information import RequestInformation as RI",
          "RI()",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from kiota_abstractions.request_information import RequestInformation",
          "def RequestInformation(value=None):",
          "    return value",
          "RequestInformation()",
        ].join("\n"),
      )

      const argEvents = await analyze(
        [
          "from kiota_abstractions.request_information import RequestInformation",
          "RequestInformation('x')",
          "RequestInformation(url='x')",
        ].join("\n"),
      )

      expect(moduleQualifiedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:kiota_abstractions.request_information.RequestInformation" }]))
      expect(aliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:kiota_abstractions.request_information.RequestInformation" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:RequestInformation" }]))
      expect(argEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:kiota_abstractions.request_information.RequestInformation" }]))
      expect(argEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "kiota_abstractions.request_information.RequestInformation" }]))
    })
  })

  describe("tabulate classification", () => {
    it("classifies exact direct-import tabulate calls as pure when tablefmt is absent or literal", async () => {
      const events = await analyze(
        [
          "from tabulate import tabulate",
          "tabulate([[1]], headers=['a'])",
          "tabulate([[1]], headers=['a'], tablefmt='git_hub')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "tabulate.tabulate" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:tabulate.tabulate" }]))
    })

    it("keeps tabulate conservative when module-qualified, aliased, shadowed, or given dynamic tablefmt", async () => {
      const moduleQualifiedEvents = await analyze(
        [
          "import tabulate",
          "tabulate.tabulate([[1]], headers=['a'])",
        ].join("\n"),
      )

      const aliasEvents = await analyze(
        [
          "from tabulate import tabulate as t",
          "t([[1]], headers=['a'])",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from tabulate import tabulate",
          "def tabulate(rows, **kwargs):",
          "    return rows",
          "tabulate([[1]], headers=['a'])",
        ].join("\n"),
      )

      const dynamicFmtEvents = await analyze(
        [
          "from tabulate import tabulate",
          "fmt = table_format",
          "tabulate([[1]], headers=['a'], tablefmt=fmt)",
        ].join("\n"),
      )

      expect(moduleQualifiedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:tabulate.tabulate" }]))
      expect(aliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:tabulate.tabulate" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:tabulate" }]))
      expect(dynamicFmtEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:tabulate.tabulate" }]))
      expect(dynamicFmtEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "tabulate.tabulate" }]))
    })
  })

  describe("oci classification", () => {
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

    it("resolves OCI import aliases before classification", async () => {
      const events = await analyze("import oci as cloud\ncloud.object_storage.ObjectStorageClient(config)")
      expect(events).toEqual([{ kind: "exec", call: "oci.object_storage.ObjectStorageClient" }])
    })
  })

  describe("ghapi classification", () => {
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

    it("resolves ghapi import aliases before classification", async () => {
      const events = await analyze("import ghapi.all as ga\nga.GhApi(owner='o', repo='r')")
      expect(events).toEqual([{ kind: "exec", call: "ghapi.all.GhApi" }])
    })
  })

  describe("atlassian-python-api classification", () => {
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

    it("resolves Atlassian import aliases before constructor and instance tracking", async () => {
      const events = await analyze("import atlassian as atl\nclient = atl.Jira(url='https://example.atlassian.net')\nclient.jql('project = DEMO')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.Jira" },
          { kind: "exec", call: "atlassian.jira.jql" },
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

})

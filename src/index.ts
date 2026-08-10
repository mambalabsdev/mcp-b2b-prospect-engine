#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 400:
        message = `The ${actorLabel} run was rejected as invalid input.${detail}`;
        break;
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Ask for less per call, or run the actor on Apify directly for larger jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx from run-sync-get-dataset-items normally carries the dataset array.
  // Anything else on this path is a failure the caller must see, never an empty
  // success: surfacing it here is what keeps a failed run from reading as "no
  // results found".
  let items: unknown;
  try {
    items = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-b2b-prospect-engine",
  version: pkg.version,
});

// Prospect Engine (immutable actor ID q9rT6v64nUJdPexOQ)
server.registerTool(
  "run_prospect_engine",
  {
    title: "Run Prospect Engine",
    description:
      "A composed prospecting actor with four modes. enrich_companies resolves identity, firmographics, LinkedIn and social for each domain or company name you supply, and needs no vendor key at all. discover_jobs finds who is hiring for your keywords and resolves the real employer behind each posting, including postings a job board placed on an employer's behalf. find_contacts finds people at the companies you name, with optional email discovery and verification. full runs discovery, enrichment, ICP scoring and then contact discovery, passing only the companies at or above min_icp_score through to the contact stage. Every row comes back flat and Clay ready with per field provenance. Vendor keys are yours: you supply them, those vendors bill you directly, and the per event price covers the actor only. discover_jobs and full require a SerpApi key, which is a different vendor from the Serper key that powers people search. Note that this actor is a pass through wrapper over the live actor, so any classification behavior you see is the actor's own. Requires an APIFY_TOKEN and consumes Apify credits. Read only: it enriches and discovers, it writes nothing.",
    annotations: {
      title: "Run Prospect Engine",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    mode: z.enum(["enrich_companies", "discover_jobs", "find_contacts", "full"]).optional().describe("What to run. enrich_companies resolves identity, firmographics, LinkedIn and social for each company. discover_jobs finds who is hiring for your keywords and resolves the real employer from the job description. find_contacts finds people at each company. full chains all three. Default: \"enrich_companies\"."),
    domains: z.array(z.string()).optional().describe("One domain per line. Used by enrich_companies and find_contacts."),
    company_names: z.array(z.string()).optional().describe("One name per line. Used when you have a name but no domain."),
    keywords: z.array(z.string()).optional().describe("Roles to search for. Used by discover_jobs and full. Example: copy editor, proofreader, content editor. Default: [\"copy editor\", \"proofreader\", \"content editor\"]."),
    country: z.string().optional().describe("Two letter country code for job search, for example us or gb. Default: \"us\"."),
    location: z.string().optional().describe("Optional location filter for job search, for example New York."),
    lookback_days: z.string().optional().describe("Drop postings older than this many days. Sent as a string because Clay sends every field as a string. Default: \"30\"."),
    max_results: z.string().optional().describe("Cap on postings returned per run. Keeps a broad keyword set from running away. Default: \"25\"."),
    max_pages: z.string().optional().describe("1 to 5. Each page is one SerpAPI call, so this is the main cost dial on discovery. Default: \"1\"."),
    new_postings_only: z.string().optional().describe("true to return only postings not seen in a previous run. Default: \"false\"."),
    previous_run_date: z.string().optional().describe("YYYY-MM-DD watermark for delta detection when the cross-run cache is unavailable."),
    remote_only: z.string().optional().describe("true to keep only postings flagged remote by the board. Default: \"false\"."),
    company_size_min: z.string().optional().describe("Drop companies below this headcount. Only takes effect once headcount is known, so it applies in full mode and to any discovery row that carried an employee count. Discovery alone does not enrich."),
    company_size_max: z.string().optional().describe("Drop companies above this headcount. Same condition as the minimum."),
    exclude_staffing: z.string().optional().describe("true to drop postings from staffing and recruitment agencies. Default: \"true\"."),
    exclude_marketplaces: z.string().optional().describe("true to drop Upwork, Fiverr, Freelancer and similar gig listings. Default: \"true\"."),
    extra_marketplaces: z.array(z.string()).optional().describe("Additional marketplace names to filter out."),
    fetch_posting_page: z.string().optional().describe("true to open the job posting when the description alone does not identify the employer. Slower, and it is what catches a job board posting on an employer's behalf. Default: \"true\"."),
    target_contacts: z.string().optional().describe("1 to 25. Default: \"3\"."),
    job_titles: z.array(z.string()).optional().describe("Titles to search for when finding contacts."),
    seniority: z.array(z.string()).optional().describe("c_level, vp, director, manager, senior."),
    departments: z.array(z.string()).optional().describe("marketing, sales, engineering, product, finance, hr, operations, legal."),
    include_email: z.string().optional().describe("true to run the email waterfall. Needs an Icypeas or Prospeo key, which you supply and are billed for directly. Default: \"false\"."),
    verify_email: z.string().optional().describe("true to verify each address. Needs a Reoon or BounceBan key. Default: \"true\"."),
    score_icp: z.string().optional().describe("true to score every row against the ICP rules and tier it A to D. Default: \"true\"."),
    icp_preset: z.enum(["proofed_editorial", "generic_b2b"]).optional().describe("Which scoring model to apply. \"proofed_editorial\" scores for a seller of managed copy editing and proofreading. \"generic_b2b\" scores on hiring intent, employer resolvability and headcount with no service-specific vocabulary. Default: \"proofed_editorial\"."),
    min_icp_score: z.string().optional().describe("In full mode, only companies scoring at or above this go on to contact discovery. Default 45: at 25 the filter passed every keyword-discovered editorial posting, because 25 is the floor such a posting can score. Default: \"45\"."),
    extra_exclude_names: z.array(z.string()).optional().describe("Any company whose name contains one of these is excluded."),
    signal_taxonomy: z.array(z.record(z.unknown())).optional().describe("Override the default signal types. Each entry is an object with type, strength, title_keywords, and optional also_keywords and description_keywords."),
    include_social: z.string().optional().describe("true to resolve Facebook, Instagram, X and YouTube alongside LinkedIn. Default: \"true\"."),
    source_timeout_secs: z.string().optional().describe("5 to 120. A source that exceeds this is marked degraded and the run continues. Default: \"30\"."),
    skip_cache: z.string().optional().describe("true to ignore the 7 day cross-run cache and recompute everything. Default: \"false\"."),
    serper_api_key: z.string().optional().describe("Your Serper.dev key. Powers people search in find_contacts, which is the highest-coverage layer. Without it the free fallback is measurably poor."),
    findymail_api_key: z.string().optional().describe("Your Findymail key. First provider in the email waterfall."),
    icypeas_api_key: z.string().optional().describe("Your Icypeas key. Runs on Findymail misses."),
    prospeo_api_key: z.string().optional().describe("Your Prospeo key. Runs on the residual after Findymail and Icypeas."),
    reoon_api_key: z.string().optional().describe("Your Reoon key. First email verification provider."),
    bounceban_api_key: z.string().optional().describe("Your BounceBan key. Second verifier, used for the catch-all case."),
    serpapi_key: z.string().optional().describe("Your SerpApi key. Required by discover_jobs and full. Distinct from a Serper key: different vendor."),
    },
  },
  async (args) =>
    runActor("q9rT6v64nUJdPexOQ", "Prospect Engine", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

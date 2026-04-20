import { logger } from "./logger.js";

interface GitlabRequestParams {
  gitlabUrl: string;
  token: string;
  method?: string;
  path: string;
  body?: Record<string, unknown>;
}

async function gitlabFetch<T>(params: GitlabRequestParams): Promise<T> {
  const { gitlabUrl, token, method = "GET", path, body } = params;
  const url = `${gitlabUrl}/api/v4${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
}

export async function getProjectId(gitlabUrl: string, token: string, projectPath: string): Promise<number> {
  const encoded = encodeURIComponent(projectPath);
  const project = await gitlabFetch<GitlabProject>({
    gitlabUrl,
    token,
    path: `/projects/${encoded}`,
  });
  return project.id;
}

export async function getProject(gitlabUrl: string, token: string, projectPath: string): Promise<GitlabProject> {
  const encoded = encodeURIComponent(projectPath);
  return gitlabFetch<GitlabProject>({
    gitlabUrl,
    token,
    path: `/projects/${encoded}`,
  });
}

export interface CreateMrParams {
  gitlabUrl: string;
  token: string;
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface GitlabMr {
  iid: number;
  web_url: string;
  state: string;
  title: string;
  description: string;
  merge_status: string;
}

export async function createMergeRequest(params: CreateMrParams): Promise<GitlabMr> {
  const { gitlabUrl, token, projectId, sourceBranch, targetBranch, title, description } = params;
  const mr = await gitlabFetch<GitlabMr>({
    gitlabUrl,
    token,
    method: "POST",
    path: `/projects/${projectId}/merge_requests`,
    body: {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description,
    },
  });
  logger.info(`Created MR !${mr.iid}: ${mr.web_url}`);
  return mr;
}

/**
 * Find an existing open MR for the given source branch.
 * Returns null if no open MR exists.
 */
export async function findOpenMergeRequest(
  gitlabUrl: string,
  token: string,
  projectId: number,
  sourceBranch: string,
): Promise<GitlabMr | null> {
  try {
    const mrs = await gitlabFetch<GitlabMr[]>({
      gitlabUrl,
      token,
      path: `/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`,
    });
    return mrs.length > 0 ? mrs[0] : null;
  } catch (err) {
    logger.warn(`Failed to find open MR for branch ${sourceBranch}:`, err);
    return null;
  }
}

/**
 * Update an existing MR's description (append new content).
 */
export async function updateMergeRequestDescription(
  gitlabUrl: string,
  token: string,
  projectId: number,
  mrIid: number,
  newDescription: string,
): Promise<void> {
  await gitlabFetch({
    gitlabUrl,
    token,
    method: "PUT",
    path: `/projects/${projectId}/merge_requests/${mrIid}`,
    body: { description: newDescription },
  });
  logger.info(`Updated MR !${mrIid} description`);
}

export async function getMergeRequestStatus(
  gitlabUrl: string,
  token: string,
  projectId: number,
  mrIid: number,
): Promise<GitlabMr> {
  return gitlabFetch<GitlabMr>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/merge_requests/${mrIid}`,
  });
}

export interface GitlabPipeline {
  id: number;
  status: string;
  web_url: string;
  ref: string;
}

export async function triggerPipeline(
  gitlabUrl: string,
  token: string,
  projectId: number,
  ref: string,
): Promise<GitlabPipeline> {
  const pipeline = await gitlabFetch<GitlabPipeline>({
    gitlabUrl,
    token,
    method: "POST",
    path: `/projects/${projectId}/pipeline`,
    body: { ref },
  });
  logger.info(`Triggered pipeline #${pipeline.id} on ref ${ref}`);
  return pipeline;
}

export async function getPipelineStatus(
  gitlabUrl: string,
  token: string,
  projectId: number,
  pipelineId: number,
): Promise<GitlabPipeline> {
  return gitlabFetch<GitlabPipeline>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/pipelines/${pipelineId}`,
  });
}

export interface GitlabNote {
  id: number;
  body: string;
  author: {
    id: number;
    username: string;
    name: string;
  };
  created_at: string;
  updated_at: string;
  system: boolean;
  noteable_id: number;
  noteable_type: string;
}

export async function getMergeRequestNotes(
  gitlabUrl: string,
  token: string,
  projectId: number,
  mrIid: number,
): Promise<GitlabNote[]> {
  return gitlabFetch<GitlabNote[]>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100&sort=asc`,
  });
}

// ─── Issue APIs ─────────────────────────────────────────────

export interface GitlabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  web_url: string;
  author: { id: number; username: string; name: string };
  assignees: Array<{ id: number; username: string; name: string }>;
  created_at: string;
  updated_at: string;
}

export async function listIssues(params: {
  gitlabUrl: string;
  token: string;
  projectId: number;
  state?: "opened" | "closed" | "all";
  labels?: string;            // comma-separated
  updatedAfter?: string;      // ISO
  perPage?: number;
}): Promise<GitlabIssue[]> {
  const { gitlabUrl, token, projectId, state = "opened", labels, updatedAfter, perPage = 50 } = params;
  const query: string[] = [`state=${state}`, `per_page=${perPage}`, "order_by=updated_at", "sort=desc"];
  if (labels) query.push(`labels=${encodeURIComponent(labels)}`);
  if (updatedAfter) query.push(`updated_after=${encodeURIComponent(updatedAfter)}`);

  return gitlabFetch<GitlabIssue[]>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/issues?${query.join("&")}`,
  });
}

export async function getIssue(
  gitlabUrl: string,
  token: string,
  projectId: number,
  issueIid: number,
): Promise<GitlabIssue> {
  return gitlabFetch<GitlabIssue>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/issues/${issueIid}`,
  });
}

export async function getIssueNotes(
  gitlabUrl: string,
  token: string,
  projectId: number,
  issueIid: number,
): Promise<GitlabNote[]> {
  return gitlabFetch<GitlabNote[]>({
    gitlabUrl,
    token,
    path: `/projects/${projectId}/issues/${issueIid}/notes?per_page=100&sort=asc`,
  });
}

export async function createIssueNote(params: {
  gitlabUrl: string;
  token: string;
  projectId: number;
  issueIid: number;
  body: string;
}): Promise<GitlabNote> {
  const { gitlabUrl, token, projectId, issueIid, body } = params;
  const note = await gitlabFetch<GitlabNote>({
    gitlabUrl,
    token,
    method: "POST",
    path: `/projects/${projectId}/issues/${issueIid}/notes`,
    body: { body },
  });
  logger.info(`Posted note to issue #${issueIid}: ${body.slice(0, 80)}`);
  return note;
}

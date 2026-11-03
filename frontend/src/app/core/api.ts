import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { SILENT_ERRORS } from './http-context';
import type {
  ApplyPreview,
  AuthSession,
  ImportResult,
  SettingKey,
  SettingsView,
  ApplyResult,
  Candidate,
  CandidateFilter,
  CandidateSort,
  CandidateSummary,
  Health,
  Job,
  JobInput,
  JobType,
  GroupApplyPreview,
  GroupApplyResult,
  JobGroup,
  Run,
  RunGroupsResponse,
  RunLog,
  TripInsights,
} from './models';

export interface CandidatePage {
  items: Candidate[];
  total: number;
  summary: CandidateSummary;
}

function params(values: Record<string, string | number | boolean | undefined>): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) p = p.set(k, String(v));
  return p;
}

/** Typed client for the backend REST API (`/api`). */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  health(silent = false): Observable<Health> {
    return this.http.get<Health>('/api/health', {
      context: new HttpContext().set(SILENT_ERRORS, silent),
    });
  }

  session(): Observable<AuthSession> {
    return this.http.get<AuthSession>('/api/auth/session', {
      context: new HttpContext().set(SILENT_ERRORS, true),
    });
  }

  login(password: string): Observable<void> {
    return this.http.post<void>(
      '/api/auth/login',
      { password },
      { context: new HttpContext().set(SILENT_ERRORS, true) },
    );
  }

  logout(): Observable<void> {
    return this.http.post<void>('/api/auth/logout', {});
  }

  settings(): Observable<SettingsView> {
    return this.http.get<SettingsView>('/api/settings');
  }

  updateSettings(patch: Partial<Record<SettingKey, number>>): Observable<SettingsView> {
    return this.http.patch<SettingsView>('/api/settings', patch);
  }

  exportJobs(): Observable<unknown> {
    return this.http.get<unknown>('/api/jobs/export');
  }

  importJobs(body: unknown): Observable<ImportResult> {
    return this.http.post<ImportResult>('/api/jobs/import', body);
  }

  jobTypes(): Observable<JobType[]> {
    return this.http.get<JobType[]>('/api/job-types');
  }

  jobs(): Observable<Job[]> {
    return this.http.get<Job[]>('/api/jobs');
  }

  job(id: string): Observable<Job> {
    return this.http.get<Job>(`/api/jobs/${id}`);
  }

  createJob(input: JobInput): Observable<Job> {
    return this.http.post<Job>('/api/jobs', input);
  }

  updateJob(id: string, input: Partial<JobInput>): Observable<Job> {
    return this.http.patch<Job>(`/api/jobs/${id}`, input);
  }

  deleteJob(id: string): Observable<void> {
    return this.http.delete<void>(`/api/jobs/${id}`);
  }

  startRun(jobId: string, body: { dryRun?: boolean; fullRescan?: boolean }): Observable<Run> {
    return this.http.post<Run>(`/api/jobs/${jobId}/runs`, body);
  }

  runs(jobId: string, limit = 20): Observable<{ items: Run[]; total: number }> {
    return this.http.get<{ items: Run[]; total: number }>(`/api/jobs/${jobId}/runs`, {
      params: params({ limit }),
    });
  }

  run(id: string): Observable<Run> {
    return this.http.get<Run>(`/api/runs/${id}`);
  }

  cancelRun(id: string): Observable<Run> {
    return this.http.post<Run>(`/api/runs/${id}/cancel`, {});
  }

  resumeRun(id: string): Observable<Run> {
    return this.http.post<Run>(`/api/runs/${id}/resume`, {});
  }

  logs(runId: string, after = 0): Observable<RunLog[]> {
    return this.http.get<RunLog[]>(`/api/runs/${runId}/logs`, {
      params: params({ after, limit: 1000 }),
    });
  }

  candidates(
    runId: string,
    q: CandidateFilter & { sort?: CandidateSort; limit?: number; offset?: number },
  ): Observable<CandidatePage> {
    return this.http.get<CandidatePage>(`/api/runs/${runId}/candidates`, {
      params: params({ ...q }),
    });
  }

  updateCandidates(
    runId: string,
    body: { selected: boolean; assetIds?: string[]; filter?: CandidateFilter },
  ): Observable<{ updated: number; summary: CandidateSummary }> {
    return this.http.patch<{ updated: number; summary: CandidateSummary }>(
      `/api/runs/${runId}/candidates`,
      body,
    );
  }

  applyPreview(runId: string): Observable<ApplyPreview> {
    return this.http.get<ApplyPreview>(`/api/runs/${runId}/apply-preview`);
  }

  apply(runId: string): Observable<ApplyResult> {
    return this.http.post<ApplyResult>(`/api/runs/${runId}/apply`, {});
  }

  // ---------------------------------------------------------------- group jobs

  runGroups(runId: string): Observable<RunGroupsResponse> {
    return this.http.get<RunGroupsResponse>(`/api/runs/${runId}/groups`);
  }

  /** Tick/untick groups (all when `keys` is omitted), or switch adopt ↔ new album. */
  updateRunGroups(
    runId: string,
    body: { selected?: boolean; adopt?: boolean; keys?: string[] },
  ): Observable<RunGroupsResponse & { updated: number }> {
    return this.http.patch<RunGroupsResponse & { updated: number }>(
      `/api/runs/${runId}/groups`,
      body,
    );
  }

  groupApplyPreview(runId: string): Observable<GroupApplyPreview> {
    return this.http.get<GroupApplyPreview>(`/api/runs/${runId}/apply-preview`);
  }

  groupApply(runId: string): Observable<GroupApplyResult> {
    return this.http.post<GroupApplyResult>(`/api/runs/${runId}/apply`, {});
  }

  jobGroups(jobId: string): Observable<JobGroup[]> {
    return this.http.get<JobGroup[]>(`/api/jobs/${jobId}/groups`);
  }

  updateJobGroup(
    jobId: string,
    groupId: string,
    status: 'active' | 'ignored' | 'locked',
  ): Observable<JobGroup> {
    return this.http.patch<JobGroup>(`/api/jobs/${jobId}/groups/${groupId}`, { status });
  }

  tripInsights(jobId: string): Observable<TripInsights> {
    return this.http.get<TripInsights>(`/api/jobs/${jobId}/insights`);
  }

  thumbnailUrl(assetId: string): string {
    return `/api/assets/${assetId}/thumbnail`;
  }
}

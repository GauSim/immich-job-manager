import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { SILENT_ERRORS } from './error.interceptor';
import type {
  Candidate,
  CandidateFilter,
  CandidateSort,
  CandidateSummary,
  Health,
  Job,
  JobInput,
  JobType,
  Run,
  RunLog,
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

  thumbnailUrl(assetId: string): string {
    return `/api/assets/${assetId}/thumbnail`;
  }
}

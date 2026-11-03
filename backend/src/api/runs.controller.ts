import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  RunEventsService,
  TERMINAL_STATUSES,
  type RunEvent,
} from '../events/run-events.service.js';
import type {
  JobRunEntity,
  RunLogEntity,
} from '../persistence/entities/index.js';
import { totalsOf } from '../runner/run-executor.js';
import {
  CandidatesService,
  type CandidateSummary,
  type CandidateView,
} from './candidates.service.js';
import {
  CandidateQuery,
  LogQuery,
  UpdateCandidatesDto,
  UpdateRunGroupsDto,
} from './dto.js';
import { GroupsService, type RunGroupsResponse } from './groups.service.js';
import { RunsService } from './runs.service.js';
import {
  ApplyService,
  type ApplyPreview,
  type ApplyResult,
} from '../sync/apply.service.js';
import type {
  GroupApplyPreview,
  GroupApplyResult,
} from '../sync/group-apply.service.js';
import { ZodPipe } from './validation.js';

/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000;

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly events: RunEventsService,
    private readonly candidates: CandidatesService,
    private readonly applyService: ApplyService,
    private readonly groups: GroupsService,
  ) {}

  /** Dry run: counts for the apply confirmation (read-only). */
  @Get(':id/apply-preview')
  applyPreview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplyPreview | GroupApplyPreview> {
    return this.applyService.preview(id);
  }

  /** Dry run: adds the selected candidates to the job's album. Never removes. */
  @Post(':id/apply')
  @HttpCode(200)
  apply(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplyResult | GroupApplyResult> {
    return this.applyService.apply(id);
  }

  /** Dry run: paged candidates (`?sort=-score|score|name&minScore=&maxScore=&selected=`). */
  @Get(':id/candidates')
  listCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(CandidateQuery)) query: CandidateQuery,
  ): Promise<{
    items: CandidateView[];
    total: number;
    summary: CandidateSummary;
  }> {
    return this.candidates.list(id, query);
  }

  /** Group job dry run: proposed groups (e.g. trips) with their action. */
  @Get(':id/groups')
  listGroups(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RunGroupsResponse> {
    return this.groups.runGroups(id);
  }

  /** Group job dry run: tick/untick proposed groups. */
  @Patch(':id/groups')
  updateGroups(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateRunGroupsDto)) dto: UpdateRunGroupsDto,
  ): Promise<RunGroupsResponse & { updated: number }> {
    return this.groups.selectRunGroups(id, dto);
  }

  /** Dry run: tick/untick by `assetIds` or by `filter`. */
  @Patch(':id/candidates')
  updateCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateCandidatesDto)) dto: UpdateCandidatesDto,
  ): Promise<{ updated: number; summary: CandidateSummary }> {
    return this.candidates.update(id, dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<JobRunEntity> {
    return this.runs.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(202)
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<JobRunEntity> {
    return this.runs.cancel(id);
  }

  @Post(':id/resume')
  @HttpCode(202)
  resume(@Param('id', ParseUUIDPipe) id: string): Promise<JobRunEntity> {
    return this.runs.resume(id);
  }

  @Get(':id/logs')
  logs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(LogQuery)) query: LogQuery,
  ): Promise<RunLogEntity[]> {
    return this.runs.logs(id, query);
  }

  /**
   * Server-sent events: first a `status` snapshot, then live `progress`
   * (≤ 1/s), `log` and `status` events. The stream ends after a terminal status.
   */
  @Get(':id/events')
  async stream(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Subscribe before reading the snapshot so no event falls in between.
    const buffered: RunEvent[] = [];
    let live = false;
    const write = (e: RunEvent) =>
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    const subscription = this.events.stream(id).subscribe({
      next: (e) => (live ? write(e) : buffered.push(e)),
      complete: () => res.end(),
    });

    let run: JobRunEntity;
    try {
      run = await this.runs.get(id);
    } catch (e) {
      subscription.unsubscribe();
      throw e;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    write({
      type: 'status',
      data: { status: run.status, error: run.error, ...totalsOf(run) },
    });
    if (TERMINAL_STATUSES.includes(run.status)) {
      subscription.unsubscribe();
      res.end();
      return;
    }
    live = true;
    for (const e of buffered) write(e);
    if (subscription.closed) return; // completed while buffering

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    };
    req.on('close', cleanup);
    res.on('finish', cleanup);
  }
}

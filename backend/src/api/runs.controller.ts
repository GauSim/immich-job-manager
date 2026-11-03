import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { LogQuery } from './dto.js';
import { RunsService } from './runs.service.js';
import { ZodPipe } from './validation.js';

/** SSE keep-alive comment interval (proxies drop idle connections). */
const HEARTBEAT_MS = 15_000;

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly events: RunEventsService,
  ) {}

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

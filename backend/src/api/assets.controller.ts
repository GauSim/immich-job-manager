import { Readable } from 'node:stream';
import {
  BadGatewayException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ImmichClient } from '../immich/immich.client.js';
import { ImmichApiError } from '../immich/immich.errors.js';
import { CandidatesService } from './candidates.service.js';

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly immich: ImmichClient,
    private readonly candidates: CandidatesService,
  ) {}

  /**
   * Thumbnail proxy for the review grid. Only serves assets that appeared in a
   * run of this app (SDD §12.1), so the API key cannot be used to browse the library.
   */
  @Get(':id/thumbnail')
  async thumbnail(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.candidates.isKnownAsset(id))
      throw new NotFoundException('Unknown asset');
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    let thumb;
    try {
      thumb = await this.immich.getThumbnail(id, { signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) return;
      if (e instanceof ImmichApiError && e.status === 404)
        throw new NotFoundException('Asset not found in Immich');
      throw new BadGatewayException((e as Error).message);
    }
    res.status(200).set({
      'Content-Type': thumb.contentType,
      'Cache-Control': 'private, max-age=86400',
      ...(thumb.contentLength !== undefined
        ? { 'Content-Length': String(thumb.contentLength) }
        : {}),
    });
    Readable.fromWeb(thumb.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', () => res.destroy())
      .pipe(res);
  }
}

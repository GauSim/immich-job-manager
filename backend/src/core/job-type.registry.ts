import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { AlbumJobType } from './album-job-type.decorator.js';
import type { JobType } from './job-type.js';

export interface JobTypeInfo {
  id: string;
  name: string;
  description?: string;
  version: number;
  /** JSON Schema (draft-07) of the params, for the generated UI form. */
  paramsSchema: unknown;
  defaultParams: unknown;
}

export class UnknownJobTypeError extends Error {
  constructor(public readonly typeId: string) {
    super(`Unknown job type "${typeId}"`);
    this.name = 'UnknownJobTypeError';
  }
}

/** All `@AlbumJobType()` providers, by id. */
@Injectable()
export class JobTypeRegistry implements OnModuleInit {
  private readonly logger = new Logger(JobTypeRegistry.name);
  private readonly types = new Map<string, JobType>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: AlbumJobType.KEY,
    })) {
      const type = wrapper.instance as JobType | undefined;
      if (!type) continue;
      this.register(type);
    }
    this.logger.log(
      `Job types: ${[...this.types.keys()].join(', ') || '(none)'}`,
    );
  }

  register(type: JobType): void {
    if (this.types.has(type.id))
      throw new Error(`Duplicate job type id "${type.id}"`);
    // Fail at boot if the defaults don't satisfy the type's own schema.
    const check = type.params.safeParse(type.defaultParams);
    if (!check.success)
      throw new Error(
        `Job type "${type.id}" has invalid defaultParams: ${check.error.message}`,
      );
    this.types.set(type.id, type);
  }

  get(id: string): JobType {
    const type = this.types.get(id);
    if (!type) throw new UnknownJobTypeError(id);
    return type;
  }

  has(id: string): boolean {
    return this.types.has(id);
  }

  list(): JobTypeInfo[] {
    return [...this.types.values()].map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      version: t.version,
      paramsSchema: z.toJSONSchema(t.params, {
        io: 'input',
        target: 'draft-7',
      }),
      defaultParams: t.defaultParams,
    }));
  }

  /** Validates params against the type schema, filling defaults. */
  parseParams(
    id: string,
    params: unknown,
  ): { success: true; data: unknown } | { success: false; error: z.ZodError } {
    const type = this.get(id);
    const merged = {
      ...(type.defaultParams as object),
      ...(params as object | null | undefined),
    };
    return type.params.safeParse(merged);
  }
}

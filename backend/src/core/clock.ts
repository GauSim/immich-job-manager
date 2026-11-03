import { Injectable } from '@nestjs/common';

/**
 * The current time for decisions that depend on it (e.g. whether a trip is
 * still ongoing). Replaceable in tests to move through time.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

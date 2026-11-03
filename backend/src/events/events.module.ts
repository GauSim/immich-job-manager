import { Global, Module } from '@nestjs/common';
import {
  PROGRESS_INTERVAL_MS,
  RunEventsService,
} from './run-events.service.js';

@Global()
@Module({
  providers: [
    {
      provide: RunEventsService,
      useFactory: () => new RunEventsService(PROGRESS_INTERVAL_MS),
    },
  ],
  exports: [RunEventsService],
})
export class EventsModule {}

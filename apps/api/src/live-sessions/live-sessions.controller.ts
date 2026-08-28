import { Controller, Param, Post, Query } from '@nestjs/common';
import { LiveSessionsService } from './live-sessions.service';

@Controller('live-sessions')
export class LiveSessionsController {
  constructor(private readonly liveSessionsService: LiveSessionsService) {}

  @Post('standardize/:batchId')
  standardize(
    @Param('batchId') batchId: string,
    @Query('orderBatchId') orderBatchId?: string,
  ) {
    return this.liveSessionsService.standardizeBatch(batchId, orderBatchId);
  }
}

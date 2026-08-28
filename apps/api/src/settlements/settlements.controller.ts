import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SettlementsService } from './settlements.service';

@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  @Post('standardize/:batchId')
  standardize(
    @Param('batchId') batchId: string,
    @Query('orderBatchId') orderBatchId?: string,
  ) {
    return this.settlementsService.standardizeBatch(batchId, orderBatchId);
  }

  @Get()
  listSettlements(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.settlementsService.listSettlements(
      page ? Number.parseInt(page, 10) : 1,
      pageSize ? Number.parseInt(pageSize, 10) : 20,
    );
  }

  @Get('by-order/:mainOrderNo')
  getOrderSettlements(@Param('mainOrderNo') mainOrderNo: string) {
    return this.settlementsService.getOrderSettlements(mainOrderNo);
  }
}

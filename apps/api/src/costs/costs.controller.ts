import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CostsService } from './costs.service';

@Controller('costs')
export class CostsController {
  constructor(private readonly costsService: CostsService) {}

  @Get('versions')
  listVersions(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.costsService.listVersions({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('versions/:id/items')
  listVersionItems(
    @Param('id') id: string,
    @Query('query') query?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.costsService.listVersionItems(id, {
      query,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post('versions/:id/changes')
  createManualVersion(
    @Param('id') id: string,
    @Body() body: {
      changeType?: string;
      productId?: string;
      merchantCode?: string;
      productName?: string;
      unitCost?: string | number;
      reason?: string;
      effectiveFrom?: string;
    },
  ) {
    return this.costsService.createManualVersion(id, body);
  }

  @Post('standardize/:batchId')
  standardize(
    @Param('batchId') batchId: string,
    @Query('orderBatchId') orderBatchId?: string,
  ) {
    return this.costsService.standardizeBatch(batchId, orderBatchId);
  }
}

import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { IssueResolutionStatus } from '@prisma/client';
import type { Response } from 'express';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('standardize/:batchId')
  standardize(@Param('batchId') batchId: string) {
    return this.ordersService.standardizeBatch(batchId);
  }

  @Get()
  listOrders(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('batchId') batchId?: string,
    @Query('settlementBatchId') settlementBatchId?: string,
  ) {
    return this.ordersService.listOrders(
      page ? Number.parseInt(page, 10) : 1,
      pageSize ? Number.parseInt(pageSize, 10) : 20,
      batchId,
      settlementBatchId,
    );
  }

  @Get('issues')
  listIssues(
    @Query('orderBatchId') orderBatchId?: string,
    @Query('status') status?: string,
    @Query('settlementBatchId') settlementBatchId?: string,
  ) {
    const resolutionStatus = status && Object.values(IssueResolutionStatus).includes(status as IssueResolutionStatus)
      ? status as IssueResolutionStatus
      : undefined;
    return this.ordersService.listIssues(orderBatchId, resolutionStatus, settlementBatchId);
  }

  @Get('issues/export')
  async exportIssues(
    @Query('orderBatchId') orderBatchId: string | undefined,
    @Query('issueType') issueType: string | undefined,
    @Query('status') status: string | undefined,
    @Query('query') query: string | undefined,
    @Res() response: Response,
  ) {
    const resolutionStatus = status && Object.values(IssueResolutionStatus).includes(status as IssueResolutionStatus)
      ? status as IssueResolutionStatus
      : undefined;
    const file = await this.ordersService.exportIssues({ orderBatchId, issueType, status: resolutionStatus, query });
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.send(file.content);
  }

  @Patch('issues/:issueId')
  updateIssueResolution(
    @Param('issueId') issueId: string,
    @Body() body: { status?: string; note?: string },
  ) {
    if (!body.status || !Object.values(IssueResolutionStatus).includes(body.status as IssueResolutionStatus)) {
      throw new BadRequestException('异常处理状态无效');
    }
    return this.ordersService.updateIssueResolution(
      issueId,
      body.status as IssueResolutionStatus,
      body.note,
    );
  }

  @Get('summary')
  getSummary(
    @Query('orderBatchId') orderBatchId?: string,
    @Query('settlementBatchId') settlementBatchId?: string,
  ) {
    return this.ordersService.getSummary(orderBatchId ?? '', settlementBatchId);
  }

  @Get('summary-months')
  getSummaryMonths() {
    return this.ordersService.getSummaryMonths();
  }

  @Get('monthly-summary')
  getMonthlySummary(@Query('accountingMonth') accountingMonth?: string) {
    return this.ordersService.getMonthlySummary(accountingMonth ?? '');
  }

  @Get(':mainOrderNo')
  getOrder(@Param('mainOrderNo') mainOrderNo: string, @Query('settlementBatchId') settlementBatchId?: string) {
    return this.ordersService.getOrderByMainOrderNo(mainOrderNo, settlementBatchId);
  }
}

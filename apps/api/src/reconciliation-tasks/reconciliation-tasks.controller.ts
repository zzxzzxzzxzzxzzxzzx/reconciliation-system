import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ReconciliationTasksService } from './reconciliation-tasks.service';

@Controller('reconciliation-tasks')
export class ReconciliationTasksController {
  constructor(private readonly service: ReconciliationTasksService) {}

  @Post()
  create(@Body() body: {
    accountingMonth?: string;
    orderBatchId?: string;
    settlementBatchId?: string;
    costBatchId?: string;
    liveBatchId?: string;
    sourceIssueId?: string;
    supplementTarget?: string;
  }) {
    return this.service.create(body);
  }

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.service.list(includeArchived === 'true');
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.service.run(id);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.service.setArchived(id, true);
  }

  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.service.setArchived(id, false);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.deleteTask(id);
  }
}

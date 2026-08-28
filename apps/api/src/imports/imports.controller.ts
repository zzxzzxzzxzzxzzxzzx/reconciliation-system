import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportsService } from './imports.service';
import type { Response } from 'express';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('orders')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  importOrders(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('请选择需要导入的订单文件');
    }

    return this.importsService.importOrders(file);
  }

  @Post('settlements')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  importSettlements(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('请选择需要导入的结算文件');
    }

    return this.importsService.importSettlements(file);
  }

  @Post('costs')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  importCosts(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('请选择需要导入的成本文件');
    }

    return this.importsService.importCosts(file);
  }

  @Post('live-sessions')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  importLiveSessions(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('请选择需要导入的直播明细文件');
    }

    return this.importsService.importLiveSessions(file);
  }

  @Get()
  listBatches(@Query('dataType') dataType?: string, @Query('includeArchived') includeArchived?: string) {
    return this.importsService.listBatches(dataType, includeArchived === 'true');
  }

  @Post('batch/archive')
  archiveBatches(@Body() body: { batchIds?: string[] }) {
    return this.importsService.setManyArchived(body.batchIds, true);
  }

  @Post('batch/restore')
  restoreBatches(@Body() body: { batchIds?: string[] }) {
    return this.importsService.setManyArchived(body.batchIds, false);
  }

  @Delete('batch')
  deleteBatches(@Body() body: { batchIds?: string[] }) {
    return this.importsService.deleteManyBatches(body.batchIds);
  }

  @Delete(':batchId')
  deleteBatch(@Param('batchId') batchId: string) {
    return this.importsService.deleteBatch(batchId);
  }

  @Post(':batchId/archive')
  archiveBatch(@Param('batchId') batchId: string) {
    return this.importsService.setArchived(batchId, true);
  }

  @Post(':batchId/restore')
  restoreBatch(@Param('batchId') batchId: string) {
    return this.importsService.setArchived(batchId, false);
  }

  @Get(':batchId/records')
  getRawRecords(@Param('batchId') batchId: string) {
    return this.importsService.getRawRecords(batchId);
  }

  @Get(':batchId/raw-file')
  async downloadRawFile(@Param('batchId') batchId: string, @Res() response: Response) {
    const file = await this.importsService.downloadRawFile(batchId);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('X-Original-File', file.original ? 'true' : 'false');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.send(file.content);
  }

  @Get(':batchId')
  getBatch(@Param('batchId') batchId: string) {
    return this.importsService.getBatch(batchId);
  }
}

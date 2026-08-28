import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { OrderFileParser } from '../imports/order-file.parser';
import { QianchuanController } from './qianchuan.controller';
import { QianchuanService } from './qianchuan.service';

@Module({
  controllers: [QianchuanController],
  providers: [QianchuanService, PrismaService, OrderFileParser],
})
export class QianchuanModule {}

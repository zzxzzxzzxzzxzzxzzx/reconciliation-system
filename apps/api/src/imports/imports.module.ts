import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { OrderFileParser } from './order-file.parser';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService, OrderFileParser, PrismaService],
})
export class ImportsModule {}

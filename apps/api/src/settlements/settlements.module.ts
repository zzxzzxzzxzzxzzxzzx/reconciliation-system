import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { SettlementNormalizer } from './settlement-normalizer';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';

@Module({
  controllers: [SettlementsController],
  providers: [SettlementsService, SettlementNormalizer, PrismaService],
  exports: [SettlementsService],
})
export class SettlementsModule {}

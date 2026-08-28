import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { CostsController } from './costs.controller';
import { CostsService } from './costs.service';

@Module({
  controllers: [CostsController],
  providers: [CostsService, PrismaService],
  exports: [CostsService],
})
export class CostsModule {}

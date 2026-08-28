import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { LiveSessionsController } from './live-sessions.controller';
import { LiveSessionsService } from './live-sessions.service';

@Module({
  controllers: [LiveSessionsController],
  providers: [LiveSessionsService, PrismaService],
  exports: [LiveSessionsService],
})
export class LiveSessionsModule {}

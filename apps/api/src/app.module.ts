import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { PrismaService } from './infrastructure/prisma.service';
import { ImportsModule } from './imports/imports.module';
import { OrdersModule } from './orders/orders.module';
import { SettlementsModule } from './settlements/settlements.module';
import { CostsModule } from './costs/costs.module';
import { LiveSessionsModule } from './live-sessions/live-sessions.module';
import { ReconciliationTasksModule } from './reconciliation-tasks/reconciliation-tasks.module';
import { QianchuanModule } from './qianchuan/qianchuan.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ImportsModule,
    OrdersModule,
    SettlementsModule,
    CostsModule,
    LiveSessionsModule,
    ReconciliationTasksModule,
    QianchuanModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, PrismaService],
})
export class AppModule {}

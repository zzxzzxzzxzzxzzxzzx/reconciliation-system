import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';

type DependencyStatus = 'ok' | 'error';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check() {
    const database = await this.checkDatabase();

    const result = {
      status: database === 'ok' ? 'ok' : 'degraded',
      services: { api: 'ok' as const, database },
      timestamp: new Date().toISOString(),
    };

    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

}

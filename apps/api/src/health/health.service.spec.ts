import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns ok when database is available', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const service = new HealthService(prisma as never);

    await expect(service.check()).resolves.toMatchObject({
      status: 'ok',
      services: { api: 'ok', database: 'ok' },
    });
  });
});

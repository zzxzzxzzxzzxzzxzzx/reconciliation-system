import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { PublicRoute } from '../auth/public.decorator';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check() {
    return this.healthService.check();
  }
}

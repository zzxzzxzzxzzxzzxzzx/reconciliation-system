import { config } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

config({ path: resolve(process.cwd(), '../../.env') });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.WEB_URL ?? 'http://localhost:3100',
    credentials: true,
  });
  await app.listen(Number(process.env.API_PORT ?? 3001));
}

void bootstrap();

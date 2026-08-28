import { BadRequestException, Controller, Get, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { QIANCHUAN_ACCOUNTS, QianchuanService } from './qianchuan.service';

@Controller('qianchuan')
export class QianchuanController {
  constructor(private readonly qianchuanService: QianchuanService) {}

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Query('accountName') accountName?: string) {
    if (!file) throw new BadRequestException('请选择需要导入的千川消耗表');
    if (!accountName) throw new BadRequestException(`请选择千川账号：${QIANCHUAN_ACCOUNTS.join('、')}`);
    return this.qianchuanService.importSpend(file, accountName);
  }

  @Get()
  list(@Query('accountName') accountName?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.qianchuanService.list({ accountName, from, to, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('summary')
  summary(@Query('accountName') accountName?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.qianchuanService.summary({ accountName, from, to });
  }

  @Get('export')
  async export(@Query('accountName') accountName: string | undefined, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Res() response: Response) {
    const csv = await this.qianchuanService.export({ accountName, from, to });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="qianchuan-spend.csv"');
    response.send(`\ufeff${csv}`);
  }
}

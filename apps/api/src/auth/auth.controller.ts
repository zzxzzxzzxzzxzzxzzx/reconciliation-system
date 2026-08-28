import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { PublicRoute } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @PublicRoute()
  @Post('login')
  login(
    @Body() body: { username?: string; password?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const clientKey = request.ip || request.socket.remoteAddress || 'unknown';
    const result = this.authService.login(body.username?.trim() ?? '', body.password ?? '', clientKey);
    response.setHeader('Set-Cookie', this.authService.sessionCookie(result.token, result.maxAge));
    return { authenticated: true, username: result.username };
  }

  @Get('session')
  session(@Req() request: Request) {
    return { authenticated: true, username: request.user!.username };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Set-Cookie', this.authService.clearSessionCookie());
    return { authenticated: false };
  }
}

import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  LoginRequestDto,
  RefreshRequestDto,
  AuthResponseDto,
  ValidateResponseDto,
  AuthErrorResponseDto,
  LogoutResponseDto,
} from './dto/auth.swagger.dto';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
}

@ApiTags('Auth')
@Controller('auth')
export class AuthGatewayController {
  constructor(@Inject('IDENTITY') private readonly identityClient: ClientProxy) {}

  @Post('login')
  @ApiOperation({ summary: 'Login with phone number and password' })
  @ApiBody({ type: LoginRequestDto })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  login(@Body() dto: { phone_number: string; password: string }) {
    return this.identityClient.send({ cmd: 'identity.login' }, dto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshRequestDto })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  refresh(@Body() dto: { refreshToken: string }) {
    return this.identityClient.send({ cmd: 'identity.refresh' }, dto);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  @ApiOkResponse({ type: LogoutResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  logout(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.logout' }, { userId: req.user.sub });
  }

  @Get('validate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate current JWT token' })
  @ApiOkResponse({ type: ValidateResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  validate(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.validate' }, { userId: req.user.sub });
  }

  @Get('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({ type: ValidateResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  myProfile(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.validate' }, { userId: req.user.sub });
  }
}

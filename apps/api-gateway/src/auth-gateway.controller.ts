import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  LoginRequestDto,
  RegisterRequestDto,
  RefreshRequestDto,
  AuthResponseDto,
  ValidateResponseDto,
  AuthErrorResponseDto,
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

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterRequestDto })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ type: AuthErrorResponseDto })
  register(@Body() dto: { username: string; phone_number: string; password: string }) {
    return this.identityClient.send({ cmd: 'identity.register' }, dto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with phone number and password' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  login(@Body() dto: { phone_number: string; password: string }) {
    return this.identityClient.send({ cmd: 'identity.login' }, dto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshRequestDto })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: AuthErrorResponseDto })
  refresh(@Body() dto: { refreshToken: string }) {
    return this.identityClient.send({ cmd: 'identity.refresh' }, dto);
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
}

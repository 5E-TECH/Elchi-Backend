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
  @ApiCreatedResponse({ description: 'Login successful' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  login(@Body() dto: { phone_number: string; password: string }) {
    return this.identityClient.send({ cmd: 'identity.login' }, dto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshRequestDto })
  @ApiCreatedResponse({ description: 'Token refreshed' })
  @ApiUnauthorizedResponse({ description: 'Invalid refresh token' })
  refresh(@Body() dto: { refreshToken: string }) {
    return this.identityClient.send({ cmd: 'identity.refresh' }, dto);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  @ApiOkResponse({ description: 'Logged out' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  logout(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.logout' }, { userId: req.user.sub });
  }

  @Get('validate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate current JWT token' })
  @ApiOkResponse({ description: 'Token valid' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  validate(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.validate' }, { userId: req.user.sub });
  }

  @Get('my-profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({ description: 'Current user profile' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  myProfile(@Req() req: { user: JwtUser }) {
    return this.identityClient.send({ cmd: 'identity.validate' }, { userId: req.user.sub });
  }
}

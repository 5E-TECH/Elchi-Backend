import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchServiceController } from './branch-service.controller';
import { BranchServiceService } from './branch-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  branchValidationSchema,
  ActivityLogModule,
} from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: branchValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'branch-service' }),
    RmqModule,
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'FILE' }),
    DatabaseModule,
    ActivityLogModule.forService('branch-service'),
    TypeOrmModule.forFeature([Branch, BranchUser, BranchConfig]),
  ],
  controllers: [BranchServiceController],
  providers: [BranchServiceService],
})
export class BranchServiceModule {}

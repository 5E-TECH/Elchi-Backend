import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchServiceController } from './branch-service.controller';
import { BranchServiceService } from './branch-service.service';
import { RmqModule, DatabaseModule, branchValidationSchema } from '@app/common';
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
    RmqModule,
    DatabaseModule,
    TypeOrmModule.forFeature([Branch, BranchUser, BranchConfig]),
  ],
  controllers: [BranchServiceController],
  providers: [BranchServiceService],
})
export class BranchServiceModule {}

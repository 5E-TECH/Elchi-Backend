import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileObject } from './entities/file-object.entity';
import { FileOwnershipService } from './file-ownership.service';
import { FileServiceController } from './file-service.controller';
import { FileServiceService } from './file-service.service';
import {
  AppLoggerModule,
  DatabaseModule,
  RmqModule,
  fileValidationSchema,
} from '@app/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: fileValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'file-service' }),
    RmqModule,
    // (dgvwZasd B) Faqat egalik reestri (`file_schema.file_objects`).
    DatabaseModule,
    TypeOrmModule.forFeature([FileObject]),
    // TODO: S3Module / MinIO connection qo'shish
  ],
  controllers: [FileServiceController],
  providers: [FileServiceService, FileOwnershipService],
})
export class FileServiceModule {}

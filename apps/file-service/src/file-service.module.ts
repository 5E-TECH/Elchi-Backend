import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FileServiceController } from './file-service.controller';
import { FileServiceService } from './file-service.service';
import { RmqModule, fileValidationSchema } from '@app/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: fileValidationSchema,
    }),
    RmqModule,
    // TODO: S3Module / MinIO connection qo'shish
  ],
  controllers: [FileServiceController],
  providers: [FileServiceService],
})
export class FileServiceModule {}

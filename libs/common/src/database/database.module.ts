import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        // Bazaga ulanish manzili .env dan olinadi
        url: configService.get<string>('POSTGRES_URI'),
        autoLoadEntities: true,
        synchronize: true, // Diqqat: Prodakshnda buni false qilish kerak!
      }),
      inject: [ConfigService],
    }),
  ],
})
export class DatabaseModule {}
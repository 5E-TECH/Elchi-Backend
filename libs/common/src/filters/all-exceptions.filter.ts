import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const msg = (exceptionResponse as Record<string, unknown>).message;
        if (Array.isArray(msg)) {
          message = msg.join('. ');
        } else if (typeof msg === 'string') {
          message = msg;
        }
      }
    } else if (exception instanceof Error) {
      const msg = exception.message || '';
      if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
        message = "Bu ma'lumot allaqachon mavjud";
      } else if (msg.includes('foreign key constraint')) {
        message = "Bog'langan ma'lumotlar mavjud, o'chirish mumkin emas";
      } else if (msg.includes('connection') || msg.includes('timeout')) {
        message = "Ma'lumotlar bazasiga ulanishda xatolik";
      } else {
        message = msg || "Noma'lum xatolik yuz berdi";
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
    });
  }
}

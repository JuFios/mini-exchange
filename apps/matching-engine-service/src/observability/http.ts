import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';

export function configureHttp(app: INestApplication, title: string): void {
  const config = app.get(ConfigService);
  app.enableCors({ origin: config.getOrThrow<string[]>('CORS_ORIGINS') });
  const secure = helmet();
  const swagger = helmet({ contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) =>
    (/^\/docs(?:\/|$)/i.test(req.path) ? swagger : secure)(req, res, next),
  );
  const options = new DocumentBuilder().setTitle(title).setVersion('1').addBearerAuth().build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, options));
}

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { assertValidConfig, loadConfig } from './config';
import { setupApp } from './setup-app';

async function bootstrap() {
  assertValidConfig(); // fail fast with a clear message instead of serving 401 for every request
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.corsOrigin.split(','), exposedHeaders: ['ETag', 'Content-Disposition', 'Retry-After'] });
  setupApp(app);

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('CRM Contacts API').setVersion('1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, doc);

  await app.listen(config.port);
  console.log(`API listening on http://localhost:${config.port}  (docs: /docs)`);
}
bootstrap();

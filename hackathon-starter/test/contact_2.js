const { expect } = require('chai');
const sinon = require('sinon');
const request = require('supertest');
const express = require('express');
const session = require('express-session');
const contactController = require('../controllers/contact');

let app;
let sendMailStub;
let fetchStub;
const OLD_ENV = { ...process.env };

//Setup inicial copiado do arquivo original
function setupApp(controller) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));

  // Set a dummy CSRF token for all requests
  app.use((req, res, next) => {
    req.flash = (type, msg) => {
      req.session[type] = msg;
    };
    req.csrfToken = () => 'testcsrf';
    res.render = () => res.status(200).send('Contact Form');
    next();
  });

  app.get('/contact', controller.getContact);
  app.post('/contact', controller.postContact);
  return app;
}

describe('Contact Controller', () => {
  before(() => {
    process.env.SITE_CONTACT_EMAIL = 'test@example.com';
    process.env.RECAPTCHA_SITE_KEY = 'dummy';
    process.env.RECAPTCHA_SECRET_KEY = 'dummy';
  });

  beforeEach(() => {
    // Stub nodemailerConfig.sendMail
    sendMailStub = sinon.stub().resolves();
    // Patch require cache for nodemailerConfig
    const nodemailerConfig = require.cache[require.resolve('../config/nodemailer')];
    if (nodemailerConfig) {
      nodemailerConfig.exports.sendMail = sendMailStub;
    }

    // Stub global fetch for reCAPTCHA
    fetchStub = sinon.stub().resolves({
      json: () => Promise.resolve({ success: true }),
    });
    global.fetch = fetchStub;

    app = setupApp(contactController);
  });

  afterEach(() => {
    sinon.restore();
    if (sendMailStub) sendMailStub.resetHistory();
    delete global.fetch;
  });

  after(() => {
    process.env = OLD_ENV;
  });

  describe('GET /contact', () => {
    //Teste 1: Valida o envio do email/mensagem para usuários que estejam conectados. Cobre toda ramificação de req.user = true. Linhas 70 - 73
    it('uses logged-in user data instead of body fields', (done) => {
      const user = {
        email: 'logged@example.com',
        profile: { name: 'Logged User' }
      };

      app.use((req, res, next) => {
        req.user = user;
        next();
      });

      request(app)
        .post('/contact')
        .type('form')
        .send({
          _csrf: 'testcsrf',
          name: 'Fake Name',
          email: 'fake@example.com',
          message: 'Hello!',
          'g-recaptcha-response': 'token'
        })
        .expect(302)
        .expect('Location', '/contact')
        .end((err) => {
          if (err) return done(err);

          const mailArgs = sendMailStub.firstCall.args[0];

          expect(mailArgs.mailOptions.from).to.equal('Logged User <logged@example.com>');

          done();
        });
    });
    //Teste 2: Valida erros de network no reCAPTCHA
    it('handles reCAPTCHA network error gracefully', (done) => {
      fetchStub.rejects(new Error('Network failure'));
      request(app)
        .post('/contact')
        .type('form')
        .send({
          _csrf: 'testcsrf',
          name: 'Test',
          email: 'test@example.com',
          message: 'Hello',
          'g-recaptcha-response': 'token'
        })
        .expect(302)
        .expect('Location', '/contact')
        .end((err) => {
          if (err) return done(err);

          expect(sendMailStub.called).to.be.false;
          done();
        });
    });

    //Teste 3: Erro no envio do email
    it('calls next(error) when sendMail fails', (done) => {
      const fakeError = new Error('SMTP down');

      // sendMail vai falhar
      sendMailStub.rejects(fakeError);

      // intercepta next()
      app.use((err, req, res, next) => {
        expect(err).to.equal(fakeError);
        return done();
      });

      request(app)
        .post('/contact')
        .type('form')
        .send({
          _csrf: 'testcsrf',
          name: 'Test',
          email: 'test@example.com',
          message: 'Hello',
          'g-recaptcha-response': 'token'
        })
        .end(() => {});
    });

    //Teste 4: reCAPTCHA sem site key
    it('skips recaptcha validation when RECAPTCHA_SITE_KEY is missing', (done) => {
      delete process.env.RECAPTCHA_SITE_KEY;

      request(app)
        .post('/contact')
        .type('form')
        .send({
          _csrf: 'testcsrf',
          name: 'Test',
          email: 'test@example.com',
          message: 'Hello',
          'g-recaptcha-response': '' // não importa
        })
        .expect(302)
        .expect('Location', '/contact')
        .end((err) => {
          if (err) return done(err);

          // E-mail deve ser enviado mesmo sem recaptcha
          expect(sendMailStub.calledOnce).to.be.true;
          done();
        });
    });


  });
});

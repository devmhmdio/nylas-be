const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mockDb = require('./utils/mock-db');
const mongoose = require('mongoose');
const Nylas = require('nylas');
const { WebhookTriggers } = require('nylas/lib/models/webhook');
const { Scope } = require('nylas/lib/models/connect');
const { openWebhookTunnel } = require('nylas/lib/services/tunnel');
const emails = require('./models/emails');
const { Configuration, OpenAIApi } = require('openai');
const reply = require('./models/reply');

dotenv.config();

const app = express();

async function connectToMongoDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB Atlas using Mongoose');
  } catch (error) {
    console.error('Error connecting to MongoDB Atlas using Mongoose:', error);
    process.exit(1);
  }
}

// Enable CORS
app.use(cors());

// The port the express app will run on
const port = process.env.PORT || 9000;

// Initialize the Nylas SDK using the client credentials
Nylas.config({
  clientId: process.env.NYLAS_CLIENT_ID,
  clientSecret: process.env.NYLAS_CLIENT_SECRET,
  apiServer: process.env.NYLAS_API_SERVER,
});

// Before we start our backend, we should register our frontend
// as a redirect URI to ensure the auth completes
const CLIENT_URI =
  process.env.CLIENT_URI || `http://localhost:${process.env.PORT || 3000}`;
Nylas.application({
  redirectUris: [CLIENT_URI],
}).then((applicationDetails) => {
  console.log(
    'Application registered. Application Details: ',
    JSON.stringify(applicationDetails)
  );
});

// Start the Nylas webhook
openWebhookTunnel({
  // Handle when a new message is created (sent)
  onMessage: function handleEvent(delta) {
    switch (delta.type) {
      case WebhookTriggers.AccountConnected:
        console.log(
          'Webhook trigger received, account connected. Details: ',
          JSON.stringify(delta.objectData, undefined, 2)
        );
        break;
    }
  },
}).then((webhookDetails) => {
  console.log('Webhook tunnel registered. Webhook ID: ' + webhookDetails.id);
});

app.get('/', (req, res) => {
  res.send('Welcome to Nylas Backend');
});

// '/nylas/generate-auth-url': This route builds the URL for
// authenticating users to your Nylas application via Hosted Authentication
app.post('/nylas/generate-auth-url', express.json(), async (req, res) => {
  const { body } = req;

  const authUrl = Nylas.urlForAuthentication({
    loginHint: body.email_address,
    redirectURI: (CLIENT_URI || '') + body.success_url,
    scopes: [Scope.EmailModify],
  });

  return res.send(authUrl);
});

// '/nylas/exchange-mailbox-token': This route exchanges an authorization
// code for an access token
// and sends the details of the authenticated user to the client
app.post('/nylas/exchange-mailbox-token', express.json(), async (req, res) => {
  const body = req.body;

  const { accessToken, emailAddress } = await Nylas.exchangeCodeForToken(
    body.token
  );

  // Normally store the access token in the DB
  console.log('Access Token was generated for: ' + emailAddress);

  // Replace this mock code with your actual database operations
  const user = await mockDb.createOrUpdateUser(emailAddress, {
    accessToken,
    emailAddress,
  });

  // Return an authorization object to the user
  return res.json({
    id: user.id,
    emailAddress: user.emailAddress,
  });
});

// Middleware to check if the user is authenticated
async function isAuthenticated(req, res, next) {
  if (!req.headers.authorization) {
    return res.status(401).json('Unauthorized');
  }

  // Query our mock db to retrieve the stored user access token
  const user = await mockDb.findUser(req.headers.authorization);

  if (!user) {
    return res.status(401).json('Unauthorized');
  }

  // Add the user to the response locals
  res.locals.user = user;

  next();
}

// Add route for getting 5 latest emails
app.get('/nylas/read-emails', isAuthenticated, async (req, res) => {
  const user = res.locals.user;
  const threads = await Nylas.with(user.accessToken).threads.list({
    limit: 5,
    expanded: true,
  });
  const createEmailPromises = threads.map(async (thread) => {
    try {
      await emails.create({
        subject: thread.subject,
        snippet: thread.snippet,
        fromEmail: thread.messages[0].from[0].email,
        ownEmail: user.emailAddress,
        userId: user.id
      });
    } catch (error) {
      if (error.name === 'MongoError' && error.code === 11000) {
        console.log('Email with the same subject and snippet already exists');
      } else {
        console.error('Unexpected error:', error);
      }
    }
  });

  try {
    await Promise.all(createEmailPromises);
    return res.status(201).json(threads);
  } catch (error) {
    console.error('Error in Promise.all:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Add route for getting individual message by id
app.get('/nylas/message', isAuthenticated, async (req, res) => {
  const user = res.locals.user;

  const { id } = req.query;
  const message = await Nylas.with(user.accessToken).messages.find(id);

  return res.json(message);
});

// Add route for downloading file
app.get('/nylas/file', isAuthenticated, async (req, res) => {
  const user = res.locals.user;

  const { id } = req.query;
  const file = await Nylas.with(user.accessToken).files.find(id);

  // Files will be returned as a binary object
  const fileData = await file.download();
  return res.end(fileData?.body);
});

// openai configuration
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Add route for reading email from database and generating replies
app.get('/nylas/read-email-gpt', isAuthenticated, async (req, res) => {
  const user = res.locals.user;
  const allEmails = await emails.find({
    ownEmail: user.emailAddress,
  });
  allEmails.forEach(async ({ subject, snippet }) => {
    const prompt = `Subject: ${subject} \n,Body: ${snippet},\n Please write a reply for the given email with subject and body sperated`;
    const response = await openai.createCompletion({
      model: 'text-davinci-003',
      prompt: prompt,
      max_tokens: 400,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    console.log('this is response', response.data.choices[0].text);
    await reply.create({
      body: response.data.choices[0].text,
      userEmail: user.emailAddress,
    })
  });
  return true;
});

// add route for displaying replies
app.get('/nylas/read-replies', isAuthenticated, async (req, res) => {
  const user = res.locals.user;
  try {
    const replies = await reply.find({ userEmail: user.emailAddress });
    return replies
  } catch (err) {
    console.error(e.message);
  }
});

// Start listening on port 9000
app.listen(port, async () => {
  await connectToMongoDB();
  console.log('App listening on port ' + port);
});

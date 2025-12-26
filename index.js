import express from 'express';
import { search } from './query.js';

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Function Calling用エンドポイント
// GET /search?q=query
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const result = await search(query);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// POST /search { q: "query" }
app.post('/search', async (req, res) => {
  const query = req.body.q;
  if (!query) {
    return res.status(400).json({ error: 'Body parameter "q" is required' });
  }

  try {
    const result = await search(query);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('RAG Engine Service is running.');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

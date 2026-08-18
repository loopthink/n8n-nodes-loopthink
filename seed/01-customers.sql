-- Stands in for a customer's own database in the Postgres example workflow.
CREATE TABLE customers (
  id          serial PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL,
  iban        text        NOT NULL,
  country     char(2)     NOT NULL,
  revenue     integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Spread over months so a date filter has something to bite on. The last two
-- are recent, which is what the created_after example selects.
INSERT INTO customers (name, email, iban, country, revenue, created_at, updated_at) VALUES
  ('Ada Lovelace',      'ada@example.com',           'DE89370400440532013000', 'DE', 124000, '2026-02-11T09:14:00Z', '2026-02-11T09:14:00Z'),
  ('Grace Hopper',      'grace@navy.example.org',    'GB29NWBK60161331926819', 'GB',  98000, '2026-03-02T16:40:00Z', '2026-07-19T11:05:00Z'),
  ('Konrad Zuse',       'konrad@zuse.example.de',    'DE12500105170648489890', 'DE',  45000, '2026-04-18T08:00:00Z', '2026-04-18T08:00:00Z'),
  ('Alan Turing',       'alan@bletchley.example.uk', 'GB94BARC10201530093459', 'GB', 210000, '2026-05-06T13:22:00Z', '2026-08-01T09:00:00Z'),
  ('Edsger Dijkstra',   'edsger@tue.example.nl',     'NL91ABNA0417164300',     'NL',  67000, '2026-05-29T07:45:00Z', '2026-05-29T07:45:00Z'),
  ('Barbara Liskov',    'barbara@mit.example.edu',   'US64SVBKUS6S3300958879', 'US', 152000, '2026-06-14T18:03:00Z', '2026-06-14T18:03:00Z'),
  ('Tim Berners-Lee',   'tim@w3.example.org',        'GB33BUKB20201555555555', 'GB',  88000, '2026-07-01T10:30:00Z', '2026-07-01T10:30:00Z'),
  ('Margaret Hamilton', 'margaret@nasa.example.gov', 'US12BOFA1234567890123456','US', 180000, '2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z'),
  ('Katherine Johnson', 'katherine@nasa.example.gov','US98CITI9876543210987654','US',  95000, '2026-08-15T15:20:00Z', '2026-08-15T15:20:00Z');

INSERT INTO categorias (nombre) VALUES
  ('Electronica'),
  ('Hogar'),
  ('Alimentos');

INSERT INTO productos (nombre, precio, categoria_id) VALUES
  ('Laptop', 15000.00, 1),
  ('Audifonos', 799.99, 1),
  ('Licuadora', 1200.50, 2),
  ('Cafetera', 950.00, 2),
  ('Arroz 1kg', 25.90, 3),
  ('Cafe molido', 89.90, 3);

INSERT INTO pedidos (producto_id, cantidad, fecha) VALUES
  (1, 1, datetime('now')),
  (5, 4, datetime('now')),
  (2, 2, datetime('now'));

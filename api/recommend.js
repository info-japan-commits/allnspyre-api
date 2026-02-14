export default function handler(req, res) {
  res.status(200).json({
    message: "Allnspyre API is working",
    method: req.method,
    timestamp: new Date().toISOString()
  });
}

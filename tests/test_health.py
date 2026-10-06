from app.server import health_body


def test_health_is_ok():
    assert health_body() == {"status": "ok"}

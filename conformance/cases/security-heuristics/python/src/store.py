password = "hunter22"
title = "hunter22"
aws_key = "AKIAABCDEFGHIJKLMNOP"


def query(name: str) -> str:
    return "SELECT id FROM users WHERE name = '" + name + "'"


def fixed() -> str:
    return "SELECT id FROM users"


def formatted(user_id: str) -> str:
    return f"DELETE FROM users WHERE id = {user_id}"

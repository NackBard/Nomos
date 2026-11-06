import ping


def pong() -> str:
    return str(ping.tick())

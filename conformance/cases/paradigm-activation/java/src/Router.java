package pa.dispatch;

class A {
}

class B {
}

class C {
}

public class Router {
    public static int route(Object x) {
        if (x instanceof A) {
            return 1;
        }

        if (x instanceof B) {
            return 2;
        }

        if (x instanceof C) {
            return 3;
        }

        return 0;
    }
}

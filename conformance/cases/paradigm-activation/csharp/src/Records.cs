namespace Pa.Records;

public record Base(int Id);

public record Child(int Id, int Extra) : Base(Id);

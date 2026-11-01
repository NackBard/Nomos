using Nomos.Abstractions;
using Nomos.Analyzers.Algorithms;
using Nomos.Analyzers.CleanCode;
using Nomos.Analyzers.Design;
using Nomos.Analyzers.Maintainability;
using Nomos.Analyzers.Patterns;
using Nomos.Analyzers.Principles;
using Nomos.Analyzers.Profiles;
using Nomos.Analyzers.Security;
using Nomos.Core;
using Nomos.Languages.CSharp;

namespace Nomos.Analyzer.CSharp;

/// <summary>The detectors of this analyzer. A test checks that no class marked [Analyzer] is left out.</summary>
public static class BuiltInComponents
{
    /// <summary>Creates the catalog of all detectors and the C# adapter.</summary>
    public static ComponentCatalog Catalog() => new(Analyzers(), [new CSharpLanguageAdapter()]);

    private static IAnalyzer[] Analyzers() =>
    [
        new TimeComplexityAnalyzer(), new QuadraticPatternAnalyzer(), new HotLoopAllocationAnalyzer(), new SpaceComplexityAnalyzer(),
        new PlaceholderAnalyzer(), new CommentedOutCodeAnalyzer(), new DeadCodeAnalyzer(), new EmptyCatchAnalyzer(), new NamingAnalyzer(),
        new LongMethodAnalyzer(), new LargeClassAnalyzer(), new TooManyParametersAnalyzer(), new DeepNestingAnalyzer(),
        new MainSequenceAnalyzer(), new DependencyCycleAnalyzer(), new LayerViolationAnalyzer(), new GodClassAnalyzer(), new FeatureEnvyAnalyzer(), new BlastRadiusAnalyzer(),
        new CyclomaticComplexityAnalyzer(), new MaintainabilityIndexAnalyzer(), new DuplicationAnalyzer(), new TestCoverageAnalyzer(),
        new ImpureFunctionAnalyzer(), new LambdaSideEffectAnalyzer(), new MutableStateAnalyzer(), new NonTailRecursionAnalyzer(), new HigherOrderDepthAnalyzer(),
        new EncapsulationAnalyzer(), new InheritanceDepthAnalyzer(), new PolymorphismAnalyzer(), new CohesionAnalyzer(), new CouplingAnalyzer(), new RefusedBequestAnalyzer(),
        new GotoAnalyzer(), new GlobalStateAnalyzer(), new ModuleSizeAnalyzer(),
        new SingletonAnalyzer(), new FactoryAnalyzer(), new StrategyAnalyzer(), new ObserverAnalyzer(), new DecoratorAnalyzer(), new RepositoryAnalyzer(), new BuilderAnalyzer(),
        new ServiceLocatorAnalyzer(), new AnemicDomainModelAnalyzer(), new MiddleManAnalyzer(),
        new SingleResponsibilityAnalyzer(), new OpenClosedAnalyzer(), new LiskovSubstitutionAnalyzer(), new InterfaceSegregationAnalyzer(), new DependencyInversionAnalyzer(),
        new DontRepeatYourselfAnalyzer(), new KeepItSimpleAnalyzer(), new YouArentGonnaNeedItAnalyzer(), new LawOfDemeterAnalyzer(),
        new HardcodedSecretAnalyzer(), new InsecureDeserializationAnalyzer(), new SqlConcatenationAnalyzer(),
    ];
}

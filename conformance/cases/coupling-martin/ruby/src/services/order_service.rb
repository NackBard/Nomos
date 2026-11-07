module Shop
  module Services
    class OrderService
      def initialize(repo)
        raise ArgumentError unless repo.is_a?(Domain::Repo)

        @repo = repo
      end

      def last
        @last ||= Domain::Entity.new
      end
    end
  end
end

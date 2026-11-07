module Shop
  module App
    class Program
      def service
        @service ||= Services::OrderService.new(repo)
      end

      def repo
        @repo ||= Infra::SqlRepo.new
      end
    end
  end
end
